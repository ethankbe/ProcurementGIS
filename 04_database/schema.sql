CREATE TABLE IF NOT EXISTS addresses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  clean_address VARCHAR(500) NOT NULL,
  raw_address TEXT,
  lat DOUBLE, lon DOUBLE,
  geo_precision VARCHAR(20),
  UNIQUE KEY uq_clean_address (clean_address),
  KEY idx_addr_geo (lat, lon)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS entities (
  id INT AUTO_INCREMENT PRIMARY KEY,
  entity_key VARCHAR(500) NOT NULL,
  name VARCHAR(300), city VARCHAR(150),
  region VARCHAR(100) NULL, province VARCHAR(150) NULL,
  address_id INT NULL,
  UNIQUE KEY uq_entity_key (entity_key),
  KEY idx_ent_addr (address_id),
  FOREIGN KEY (address_id) REFERENCES addresses(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS contracts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  bid_ref VARCHAR(40) NOT NULL,
  award_no VARCHAR(40),
  awardee VARCHAR(255),       
  entity_id INT NULL,
  title TEXT, unit VARCHAR(200),
  classification VARCHAR(100), category VARCHAR(150),
  abc DECIMAL(16,2),
  published DATE, status VARCHAR(60),
  UNIQUE KEY uq_bid_ref (bid_ref),
  KEY idx_con_ent (entity_id),
  KEY idx_con_published (published),
  FOREIGN KEY (entity_id) REFERENCES entities(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  bid_ref VARCHAR(40) NOT NULL,
  item_name VARCHAR(500),
  item_desc TEXT,
  quantity DECIMAL(18,4),
  uom VARCHAR(60),
  item_budget DECIMAL(18,2),
  KEY idx_item_bid (bid_ref),
  KEY idx_item_name (item_name(100))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;